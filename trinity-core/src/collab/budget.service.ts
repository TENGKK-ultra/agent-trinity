import type { DatabaseSync } from 'node:sqlite';
import { withTransaction } from '../database/transaction.ts';
import { appError } from '../types/index.ts';
import { findRound, type RoundRow } from './messages.service.ts';

/**
 * Three budgets, each measuring a different thing (§8.1):
 *
 *   hops  — how far a message may travel between agents (already in place)
 *   exec  — how many agent turns this round may start (task runs, checkpoints,
 *           planning, review, delivery all count as one)
 *   usage — how many tokens the round may spend, read from `agent_usage`
 *
 * They are separate on purpose: one agent retrying inside its own turn raises no
 * hop and sends no message, but it does burn turns and tokens.
 */
export const DEFAULT_BUDGET_EXEC = 12;

export type BudgetScope = 'hops' | 'exec' | 'usage';

export interface UsageTotals {
  /** null when every recorded row had an unknown total; never reported as 0. */
  tokens: number | null;
  costUsd: number | null;
  /** Rows that belong to this round's tasks or were written with its id. */
  rows: number;
}

function budgetError(scope: BudgetScope, message: string): Error {
  const err = appError('budget_exhausted', message, 409) as unknown as Error & {
    scope: BudgetScope;
  };
  err.scope = scope;
  return err;
}

/** Tokens and cost this round has already spent, from the shared ledger. */
export function usageOf(db: DatabaseSync, roundId: string): UsageTotals {
  const row = db
    .prepare(
      `SELECT SUM(normalized_total_tokens) AS tokens,
              SUM(provider_cost_usd)     AS cost_usd,
              COUNT(*)                   AS rows
         FROM agent_usage
        WHERE round_id = ?
           OR task_id IN (SELECT id FROM agent_tasks WHERE chain_id = ?)`,
    )
    .get(roundId, roundId) as
    | { tokens: number | null; cost_usd: number | null; rows: number }
    | undefined;

  return {
    tokens: row?.tokens ?? null,
    costUsd: row?.cost_usd ?? null,
    rows: Number(row?.rows ?? 0),
  };
}

export function execLeft(db: DatabaseSync, roundId: string): number {
  const row = db
    .prepare('SELECT budget_exec, exec_used FROM collab_rounds WHERE id = ?')
    .get(roundId) as { budget_exec: number; exec_used: number } | undefined;

  if (!row) throw appError('round_not_found', 'Round not found', 404);

  return Math.max(row.budget_exec - row.exec_used, 0);
}

export function usageLeft(db: DatabaseSync, roundId: string): number | null {
  const round = findRound(db, roundId);

  if (!round) throw appError('round_not_found', 'Round not found', 404);
  if (round.budget_usage_tokens === null) return null;

  return Math.max(round.budget_usage_tokens - (usageOf(db, roundId).tokens ?? 0), 0);
}

/**
 * Reserves one agent turn. A single conditional update is the whole check: two
 * callers racing for the last slot cannot both see it as free.
 */
export function claimExec(db: DatabaseSync, roundId: string): boolean {
  const result = db
    .prepare(
      `UPDATE collab_rounds
          SET exec_used = exec_used + 1
        WHERE id = ? AND exec_used < budget_exec
          AND status NOT IN ('delivered', 'failed', 'cancelled')`,
    )
    .run(roundId);

  return Number(result.changes) === 1;
}

/**
 * The gate every new turn passes. Usage is checked first: when the wallet is
 * empty the round must stop and ask, not spend the last turn discovering it.
 */
export function assertBudgetAllowsWork(db: DatabaseSync, roundId: string): void {
  const round = findRound(db, roundId);

  if (!round) throw appError('round_not_found', 'Round not found', 404);

  if (round.status === 'blocked') {
    throw budgetError('usage', 'Round is blocked awaiting a wake condition');
  }

  if (round.budget_usage_tokens !== null) {
    const used = usageOf(db, roundId).tokens;

    if (used !== null && used >= round.budget_usage_tokens) {
      throw budgetError(
        'usage',
        `Usage budget is ${round.budget_usage_tokens} tokens; this round has used ${used}`,
      );
    }
  }

  if (!claimExec(db, roundId)) {
    throw budgetError(
      'exec',
      `Execution budget is ${round.budget_exec} turns and all of them have been used`,
    );
  }
}

export interface RoundBudgetInput {
  budgetHops?: number;
  budgetExec?: number;
  budgetUsageTokens?: number | null;
}

function assertBudgetNumbers(input: RoundBudgetInput): void {
  const checks: Array<[string, number | null | undefined]> = [
    ['budget_hops', input.budgetHops],
    ['budget_exec', input.budgetExec],
    ['budget_usage_tokens', input.budgetUsageTokens],
  ];

  for (const [field, value] of checks) {
    if (value === undefined || value === null) continue;

    if (!Number.isInteger(value) || value < 0) {
      throw appError(`invalid_${field}`, `${field} must be a non-negative integer`, 400);
    }
  }
}

export function setRoundBudget(
  db: DatabaseSync,
  roundId: string,
  input: RoundBudgetInput,
): RoundRow {
  assertBudgetNumbers(input);

  if (!findRound(db, roundId)) {
    throw appError('round_not_found', 'Round not found', 404);
  }

  return withTransaction(db, () => {
    db.prepare(
      `UPDATE collab_rounds
          SET budget_hops = COALESCE(?, budget_hops),
              budget_exec = COALESCE(?, budget_exec),
              budget_usage_tokens = CASE WHEN ? THEN ? ELSE budget_usage_tokens END
        WHERE id = ?`,
    ).run(
      input.budgetHops ?? null,
      input.budgetExec ?? null,
      input.budgetUsageTokens === undefined ? 0 : 1,
      input.budgetUsageTokens ?? null,
      roundId,
    );

    return findRound(db, roundId) as RoundRow;
  });
}

/**
 * The user's answer to "the wallet is empty". Raising the ceiling is a decision
 * only the user makes, so the caller must have come from an explicit request.
 */
export function raiseUsageBudget(
  db: DatabaseSync,
  roundId: string,
  tokens: number,
): RoundRow {
  if (!Number.isInteger(tokens) || tokens < 0) {
    throw appError('invalid_budget_usage_tokens', 'tokens must be a non-negative integer', 400);
  }

  if (!findRound(db, roundId)) {
    throw appError('round_not_found', 'Round not found', 404);
  }

  return withTransaction(db, () => {
    db.prepare('UPDATE collab_rounds SET budget_usage_tokens = ? WHERE id = ?').run(
      tokens,
      roundId,
    );

    return findRound(db, roundId) as RoundRow;
  });
}
