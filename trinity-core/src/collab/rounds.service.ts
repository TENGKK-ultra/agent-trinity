import type { DatabaseSync } from 'node:sqlite';
import { withTransaction } from '../database/transaction.ts';
import { appError } from '../types/index.ts';
import { findRound, type RoundRow } from './messages.service.ts';

export type RoundStatus =
  | 'created'
  | 'planning'
  | 'running'
  | 'reviewing'
  | 'blocked'
  | 'delivered'
  | 'failed'
  | 'cancelled';

export type RoundOutcome = 'completed' | 'partially_completed' | 'failed' | 'cancelled';

const TERMINAL: readonly RoundStatus[] = ['delivered', 'failed', 'cancelled'];

const ALLOWED: Record<RoundStatus, readonly RoundStatus[]> = {
  created: ['planning', 'running', 'cancelled'],
  planning: ['running', 'blocked', 'failed', 'cancelled'],
  running: ['reviewing', 'blocked', 'delivered', 'failed', 'cancelled'],
  reviewing: ['running', 'delivered', 'failed', 'cancelled'],
  blocked: ['running', 'failed', 'cancelled'],
  delivered: [],
  failed: [],
  cancelled: [],
};

const OUTCOMES: Record<RoundStatus, readonly RoundOutcome[]> = {
  created: [],
  planning: [],
  running: [],
  reviewing: [],
  blocked: [],
  delivered: ['completed', 'partially_completed'],
  failed: ['failed', 'partially_completed'],
  cancelled: ['cancelled', 'partially_completed'],
};

export function isTerminalStatus(status: string): boolean {
  return (TERMINAL as readonly string[]).includes(status);
}

export function setRoundStatus(
  db: DatabaseSync,
  roundId: string,
  next: RoundStatus,
  options: { outcome?: RoundOutcome } = {},
): RoundRow {
  const round = findRound(db, roundId);

  if (!round) {
    throw appError('round_not_found', 'Round not found', 404);
  }

  const current = round.status as RoundStatus;

  if (current === next) return round;

  if (isTerminalStatus(current)) {
    throw appError('round_closed', `Round is already ${current}`, 409);
  }

  if (!ALLOWED[current].includes(next)) {
    throw appError('invalid_transition', `Cannot move a round from ${current} to ${next}`, 409);
  }

  const outcome = options.outcome ?? null;

  if (isTerminalStatus(next)) {
    if (!outcome || !OUTCOMES[next].includes(outcome)) {
      throw appError(
        'invalid_outcome',
        `A ${next} round needs one of: ${OUTCOMES[next].join(', ')}`,
        400,
      );
    }
  } else if (outcome !== null) {
    throw appError('invalid_outcome', 'Only a finished round carries an outcome', 400);
  }

  return withTransaction(db, () => {
    db.prepare('UPDATE collab_rounds SET status = ?, outcome = ?, closed_at = ? WHERE id = ?').run(
      next,
      outcome,
      isTerminalStatus(next) ? new Date().toISOString() : null,
      roundId,
    );

    return findRound(db, roundId) as RoundRow;
  });
}

/** A blocked round names what would wake it; otherwise it can hang forever. */
export function blockRound(
  db: DatabaseSync,
  roundId: string,
  options: {
    reason: string;
    wakeCondition: string;
    /** Where a resume should continue: planning, the work loop, or review. */
    phase?: 'planning' | 'work' | 'review' | 'delivery';
  },
): RoundRow {
  const reason = options.reason.trim();
  const wake = options.wakeCondition.trim();

  if (reason === '' || wake === '') {
    throw appError('invalid_block', 'A blocked round needs a reason and a wake condition', 400);
  }

  const round = findRound(db, roundId);

  if (!round) {
    throw appError('round_not_found', 'Round not found', 404);
  }

  if (isTerminalStatus(round.status)) {
    throw appError('round_closed', `Round is already ${round.status}`, 409);
  }

  return withTransaction(db, () => {
    db.prepare(
      `UPDATE collab_rounds
          SET status = 'blocked', blocked_reason = ?, wake_condition = ?,
              blocked_at = ?, blocked_phase = ?, outcome = NULL
        WHERE id = ?`,
    ).run(reason, wake, new Date().toISOString(), options.phase ?? 'work', roundId);

    return findRound(db, roundId) as RoundRow;
  });
}

const RESUME_TARGETS: readonly RoundStatus[] = ['running', 'planning', 'reviewing'];

/**
 * Unblocks a round. A round blocked while planning goes back to planning —
 * resuming it into the work loop would silently skip the plan it never made.
 */
export function resumeRound(
  db: DatabaseSync,
  roundId: string,
  next: RoundStatus = 'running',
): RoundRow {
  const round = findRound(db, roundId);

  if (!round) {
    throw appError('round_not_found', 'Round not found', 404);
  }

  if (round.status !== 'blocked') {
    throw appError('invalid_transition', `Round is ${round.status}, not blocked`, 409);
  }

  if (!RESUME_TARGETS.includes(next)) {
    throw appError('invalid_transition', `Cannot resume into ${next}`, 400);
  }

  return withTransaction(db, () => {
    db.prepare(
      `UPDATE collab_rounds
          SET status = ?, blocked_reason = NULL, wake_condition = NULL,
              blocked_at = NULL, blocked_phase = NULL
        WHERE id = ?`,
    ).run(next, roundId);

    return findRound(db, roundId) as RoundRow;
  });
}

export function closeRound(
  db: DatabaseSync,
  roundId: string,
  outcome: RoundOutcome,
): RoundRow {
  return setRoundStatus(db, roundId, 'delivered', { outcome });
}

export function failRound(db: DatabaseSync, roundId: string, outcome: RoundOutcome): RoundRow {
  return setRoundStatus(db, roundId, 'failed', { outcome });
}

export function cancelRound(db: DatabaseSync, roundId: string, outcome: RoundOutcome): RoundRow {
  return setRoundStatus(db, roundId, 'cancelled', { outcome });
}

/**
 * Hop budget. Propagation stops at the limit, but a task that already ran keeps
 * its result: this only refuses new messages.
 */
export function assertHopWithinBudget(db: DatabaseSync, roundId: string, hop: number): void {
  const round = findRound(db, roundId);

  if (!round) {
    throw appError('round_not_found', 'Round not found', 404);
  }

  if (hop > round.budget_hops) {
    throw appError(
      'budget_exhausted',
      `Hop budget is ${round.budget_hops}; this message would be hop ${hop}`,
      409,
    );
  }
}

export function touchHop(db: DatabaseSync, roundId: string, hop: number): void {
  db.prepare(
    'UPDATE collab_rounds SET hops_used = MAX(hops_used, ?) WHERE id = ?',
  ).run(hop, roundId);
}
