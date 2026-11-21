import type { DatabaseSync } from 'node:sqlite';
import { appError } from '../types/index.ts';

/**
 * Dates are bucketed in Asia/Shanghai (UTC+8, no daylight saving). A day starts
 * at 00:00 local, so a row recorded at 16:30Z belongs to the next local day.
 */
const DAY_OFFSET = '+8 hours';
const DAY_MS = 24 * 60 * 60 * 1000;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export interface UsageFilters {
  conversationId?: string;
  taskId?: string;
  agent?: string;
  model?: string;
  from?: string;
  to?: string;
}

export interface UsageTotals {
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  total_tokens: number | null;
  cost_usd: number | null;
}

export interface AgentUsage extends UsageTotals {
  agent: string;
}

export interface ModelUsage extends UsageTotals {
  configured_model: string | null;
}

export interface DailyUsage extends UsageTotals {
  date: string;
}

export interface UsageItemDto {
  recorded_at: string;
  agent: string;
  configured_model: string | null;
  scope: string;
  turn_id: string;
  task_id: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  total_tokens: number | null;
  cost_usd: number | null;
  anomaly: string | null;
}

interface AggregateRow {
  input_tokens: number | null;
  output_tokens: number | null;
  cache_read_tokens: number | null;
  cache_write_tokens: number | null;
  total_tokens: number | null;
  cost_usd: number | null;
}

// SUM ignores NULL inputs and returns NULL only when every input was NULL,
// which is exactly the "unknown is not zero" rule. Provider cost is the only
// cost source; reasoning tokens are deliberately absent (they are output).
const AGGREGATE_COLUMNS = `
  SUM(normalized_input_tokens) AS input_tokens,
  SUM(provider_output_tokens) AS output_tokens,
  SUM(provider_cache_read_tokens) AS cache_read_tokens,
  SUM(provider_cache_write_tokens) AS cache_write_tokens,
  SUM(normalized_total_tokens) AS total_tokens,
  SUM(provider_cost_usd) AS cost_usd
`;

interface Clauses {
  sql: string;
  params: Array<string | number>;
}

function dayStartUtc(date: string, field: string): string {
  if (!DATE_PATTERN.test(date)) {
    throw appError('invalid_date', `${field} must be YYYY-MM-DD`, 400);
  }

  const start = new Date(`${date}T00:00:00+08:00`);
  if (Number.isNaN(start.getTime())) {
    throw appError('invalid_date', `${field} is not a valid date`, 400);
  }

  return start.toISOString();
}

function buildWhere(filters: UsageFilters): Clauses {
  const parts: string[] = [];
  const params: Array<string | number> = [];

  if (filters.conversationId !== undefined) {
    parts.push('conversation_id = ?');
    params.push(filters.conversationId);
  }

  if (filters.taskId !== undefined) {
    parts.push('task_id = ?');
    params.push(filters.taskId);
  }

  if (filters.agent !== undefined) {
    parts.push('agent = ?');
    params.push(filters.agent);
  }

  if (filters.model !== undefined) {
    parts.push('model = ?');
    params.push(filters.model);
  }

  if (filters.from !== undefined) {
    parts.push('recorded_at >= ?');
    params.push(dayStartUtc(filters.from, 'from'));
  }

  if (filters.to !== undefined) {
    // `to` is inclusive: everything before the next local midnight.
    const start = new Date(dayStartUtc(filters.to, 'to')).getTime();
    parts.push('recorded_at < ?');
    params.push(new Date(start + DAY_MS).toISOString());
  }

  return { sql: parts.length === 0 ? '' : `WHERE ${parts.join(' AND ')}`, params };
}

function toTotals(row: AggregateRow | undefined): UsageTotals {
  return {
    input_tokens: row?.input_tokens ?? null,
    output_tokens: row?.output_tokens ?? null,
    cache_read_tokens: row?.cache_read_tokens ?? null,
    cache_write_tokens: row?.cache_write_tokens ?? null,
    total_tokens: row?.total_tokens ?? null,
    cost_usd: row?.cost_usd ?? null,
  };
}

export function usageSummary(
  db: DatabaseSync,
  filters: UsageFilters,
): { totals: UsageTotals; by_agent: AgentUsage[]; by_model: ModelUsage[] } {
  const where = buildWhere(filters);

  const totals = db
    .prepare(`SELECT ${AGGREGATE_COLUMNS} FROM agent_usage ${where.sql}`)
    .get(...where.params) as AggregateRow | undefined;

  const agents = db
    .prepare(
      `SELECT agent, ${AGGREGATE_COLUMNS} FROM agent_usage ${where.sql}
        GROUP BY agent ORDER BY agent`,
    )
    .all(...where.params) as unknown as Array<AggregateRow & { agent: string }>;

  const models = db
    .prepare(
      `SELECT model AS configured_model, ${AGGREGATE_COLUMNS} FROM agent_usage ${where.sql}
        GROUP BY model ORDER BY configured_model`,
    )
    .all(...where.params) as unknown as Array<AggregateRow & { configured_model: string | null }>;

  return {
    totals: toTotals(totals),
    by_agent: agents.map((row) => ({ agent: row.agent, ...toTotals(row) })),
    by_model: models.map((row) => ({
      configured_model: row.configured_model,
      ...toTotals(row),
    })),
  };
}

export function usageDaily(db: DatabaseSync, filters: UsageFilters): DailyUsage[] {
  const where = buildWhere(filters);

  const rows = db
    .prepare(
      `SELECT date(recorded_at, '${DAY_OFFSET}') AS day, ${AGGREGATE_COLUMNS}
         FROM agent_usage ${where.sql}
        GROUP BY day ORDER BY day ASC`,
    )
    .all(...where.params) as unknown as Array<AggregateRow & { day: string }>;

  // Days with no rows are omitted rather than zero-filled: a gap is unknown,
  // not zero, and the client can see the range it asked for.
  return rows.map((row) => ({ date: row.day, ...toTotals(row) }));
}

export function listUsage(
  db: DatabaseSync,
  filters: UsageFilters,
  limit: number,
  offset: number,
): UsageItemDto[] {
  const where = buildWhere(filters);

  const rows = db
    .prepare(
      `SELECT recorded_at, agent, model AS configured_model, scope, turn_id, task_id,
              normalized_input_tokens AS input_tokens,
              provider_output_tokens AS output_tokens,
              provider_cache_read_tokens AS cache_read_tokens,
              provider_cache_write_tokens AS cache_write_tokens,
              normalized_total_tokens AS total_tokens,
              provider_cost_usd AS cost_usd,
              anomaly
         FROM agent_usage ${where.sql}
        ORDER BY recorded_at DESC, rowid DESC
        LIMIT ? OFFSET ?`,
    )
    .all(...where.params, limit, offset) as unknown as UsageItemDto[];

  return rows.map((row) => ({ ...row }));
}

export function conversationUsage(
  db: DatabaseSync,
  conversationId: string,
  filters: UsageFilters,
  limit: number,
  offset: number,
): {
  totals: UsageTotals;
  by_agent: AgentUsage[];
  items: UsageItemDto[];
} {
  const scoped: UsageFilters = { ...filters, conversationId };
  const { totals, by_agent } = usageSummary(db, scoped);

  return { totals, by_agent, items: listUsage(db, scoped, limit, offset) };
}

export function taskUsage(
  db: DatabaseSync,
  taskId: string,
  filters: UsageFilters,
): { totals: UsageTotals; by_agent: AgentUsage[] } {
  const { totals, by_agent } = usageSummary(db, { ...filters, taskId });

  return { totals, by_agent };
}
