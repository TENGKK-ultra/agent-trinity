import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { withTransaction } from '../database/transaction.ts';

export type UsageAgent = 'claude' | 'codex' | 'deepseek';
export type UsageScope = 'turn' | 'step';
export type CounterScope = 'turn' | 'thread';

export type UsageAnomaly =
  | 'cache_read_exceeds_input'
  | 'counter_went_backwards'
  | 'missing_session_for_thread_counter'
  | 'missing_step_identity';

/**
 * What a provider reported, before any interpretation. `cacheInInput` is the
 * one semantic that differs between providers: Codex counts cached tokens
 * inside `input_tokens`, Claude and DSH list them beside it.
 */
export interface ProviderUsage {
  inputTokens: number | null;
  outputTokens: number | null;
  reasoningOutputTokens?: number | null;
  cacheReadTokens: number | null;
  cacheWriteTokens: number | null;
  /** Only what the provider itself stated; never computed here. */
  totalTokens?: number | null;
  costUsd?: number | null;
  cacheInInput: boolean;
}

export interface RecordUsageInput {
  agent: UsageAgent;
  conversationId: string;
  turnId: string;
  providerSessionId: string | null;
  taskId: string | null;
  /** Set for turns that belong to a collaboration round. */
  roundId?: string | null;
  /** The model configured when the turn started; null when none is set. */
  model?: string | null;
  scope: UsageScope;
  providerTurn?: number;
  providerStep?: number;
  counterScope: CounterScope;
  usage: ProviderUsage;
  /** A problem the provider reported about the event itself, not its numbers. */
  anomaly?: UsageAnomaly;
  recordedAt?: string;
}

export interface RecordUsageResult {
  inserted: boolean;
  anomaly: UsageAnomaly | null;
}

interface BaselineRow {
  provider_input_tokens: number | null;
  provider_output_tokens: number | null;
  provider_cache_read_tokens: number | null;
  provider_cache_write_tokens: number | null;
}

function subtract(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null) return null;
  return current - previous;
}

/** Turns a running thread total into this turn's own numbers. */
function deltaUsage(current: ProviderUsage, previous: BaselineRow): ProviderUsage {
  return {
    ...current,
    inputTokens: subtract(current.inputTokens, previous.provider_input_tokens),
    outputTokens: subtract(current.outputTokens, previous.provider_output_tokens),
    cacheReadTokens: subtract(current.cacheReadTokens, previous.provider_cache_read_tokens),
    cacheWriteTokens: subtract(current.cacheWriteTokens, previous.provider_cache_write_tokens),
  };
}

interface Normalized {
  input: number | null;
  total: number | null;
  anomaly: UsageAnomaly | null;
}

/**
 * The one place provider numbers become comparable. A missing component makes
 * the total null — "unknown" must never be reported as zero.
 */
export function normalizeUsage(effective: ProviderUsage): Normalized {
  let input = effective.inputTokens;
  let anomaly: UsageAnomaly | null = null;

  if (effective.cacheInInput) {
    if (input === null || effective.cacheReadTokens === null) {
      input = null;
    } else if (effective.cacheReadTokens > input) {
      anomaly = 'cache_read_exceeds_input';
      input = null;
    } else {
      input = input - effective.cacheReadTokens;
    }
  }

  const parts = [
    input,
    effective.outputTokens,
    effective.cacheReadTokens,
    effective.cacheWriteTokens,
  ];

  const total = parts.every((value) => value !== null)
    ? parts.reduce<number>((sum, value) => sum + (value ?? 0), 0)
    : null;

  return { input, total, anomaly };
}

/**
 * Writes one usage event. Dedup, baseline lookup, delta and insert share one
 * immediate transaction, so a replayed event can never advance the baseline.
 */
export function recordUsage(db: DatabaseSync, input: RecordUsageInput): RecordUsageResult {
  const providerTurn = input.providerTurn ?? -1;
  const providerStep = input.providerStep ?? -1;

  return withTransaction(db, () => {
    const existing = db
      .prepare(
        `SELECT id FROM agent_usage
          WHERE agent = ? AND turn_id = ? AND scope = ?
            AND provider_turn = ? AND provider_step = ?`,
      )
      .get(input.agent, input.turnId, input.scope, providerTurn, providerStep) as
      | { id: string }
      | undefined;

    if (existing) return { inserted: false, anomaly: null };

    let effective = input.usage;
    let anomaly: UsageAnomaly | null = input.anomaly ?? null;

    // A running total without its session has no baseline: writing it as a
    // first turn would count every previous turn again. Record the anomaly and
    // leave the normalised numbers unknown.
    if (input.counterScope === 'thread' && input.providerSessionId === null) {
      anomaly = anomaly ?? 'missing_session_for_thread_counter';
      effective = {
        ...input.usage,
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
      };
    } else if (input.counterScope === 'thread') {
      const previous = db
        .prepare(
          `SELECT provider_input_tokens, provider_output_tokens,
                  provider_cache_read_tokens, provider_cache_write_tokens
             FROM agent_usage
            WHERE agent = ? AND conversation_id = ? AND provider_session_id = ?
            ORDER BY rowid DESC
            LIMIT 1`,
        )
        .get(
          input.agent,
          input.conversationId,
          input.providerSessionId,
        ) as BaselineRow | undefined;

      if (previous !== undefined) {
        const deltas = deltaUsage(input.usage, previous);
        const wentBackwards = [
          deltas.inputTokens,
          deltas.outputTokens,
          deltas.cacheReadTokens,
          deltas.cacheWriteTokens,
        ].some((value) => value !== null && value < 0);

        if (wentBackwards) {
          anomaly = anomaly ?? 'counter_went_backwards';
          effective = {
            ...input.usage,
            inputTokens: null,
            outputTokens: null,
            cacheReadTokens: null,
            cacheWriteTokens: null,
          };
        } else {
          effective = deltas;
        }
      }
    }

    const normalized = normalizeUsage(effective);

    db.prepare(
      `INSERT INTO agent_usage
         (id, agent, conversation_id, turn_id, provider_session_id, task_id, round_id, model,
          scope, provider_turn, provider_step, counter_scope,
          provider_input_tokens, provider_output_tokens, provider_reasoning_output_tokens,
          provider_cache_read_tokens, provider_cache_write_tokens,
          provider_total_tokens, provider_cost_usd,
          cache_in_input, normalized_input_tokens, normalized_total_tokens,
          anomaly, usage_source, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      randomUUID(),
      input.agent,
      input.conversationId,
      input.turnId,
      input.providerSessionId,
      input.taskId,
      input.roundId ?? null,
      input.model ?? null,
      input.scope,
      providerTurn,
      providerStep,
      input.counterScope,
      input.usage.inputTokens,
      input.usage.outputTokens,
      input.usage.reasoningOutputTokens ?? null,
      input.usage.cacheReadTokens,
      input.usage.cacheWriteTokens,
      input.usage.totalTokens ?? null,
      input.usage.costUsd ?? null,
      input.usage.cacheInInput ? 1 : 0,
      normalized.input,
      normalized.total,
      anomaly ?? normalized.anomaly,
      'provider',
      input.recordedAt ?? new Date().toISOString(),
    );

    return { inserted: true, anomaly: anomaly ?? normalized.anomaly };
  });
}
