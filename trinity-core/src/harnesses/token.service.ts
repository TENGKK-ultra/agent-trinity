import { randomBytes } from 'node:crypto';

/**
 * Delegation tokens live only in this process. They grant exactly one thing:
 * calling `delegate_task` on behalf of one turn of one conversation. They are
 * never stored, never logged, and never accepted by any other endpoint.
 */

export interface CreationOutcome {
  ok: boolean;
  taskId: string;
  error: unknown;
}

export type Reservation =
  | { state: 'creating'; result: Promise<CreationOutcome> }
  | { state: 'created'; taskId: string };

export interface DelegationTokenEntry {
  token: string;
  conversationId: string;
  sourceAgent: string;
  sourceTurnId: string;
  /** Tasks delegated from this turn join the collaboration round they came from. */
  roundId: string | null;
  expiresAt: number;
  maxTasks: number;
  /** Slots taken by reservations in `creating` plus tasks in `created`. */
  used: number;
  reservations: Map<string, Reservation>;
}

export type Claim =
  | { type: 'reuse'; taskId: string }
  | { type: 'wait'; result: Promise<CreationOutcome> }
  | { type: 'owner'; settle: (outcome: CreationOutcome) => void }
  | { type: 'quota_exceeded' };

export type TokenRejection = 'missing' | 'unknown' | 'expired' | 'revoked';

export const DEFAULT_TOKEN_TTL_MS = 10 * 60 * 1000;
export const DEFAULT_MAX_TASKS = 4;

const tokens = new Map<string, DelegationTokenEntry>();

export function issueToken(input: {
  conversationId: string;
  sourceAgent: string;
  sourceTurnId: string;
  roundId?: string | null;
  ttlMs?: number;
  maxTasks?: number;
}): DelegationTokenEntry {
  const entry: DelegationTokenEntry = {
    token: randomBytes(32).toString('base64url'),
    conversationId: input.conversationId,
    sourceAgent: input.sourceAgent,
    sourceTurnId: input.sourceTurnId,
    roundId: input.roundId ?? null,
    expiresAt: Date.now() + (input.ttlMs ?? DEFAULT_TOKEN_TTL_MS),
    maxTasks: input.maxTasks ?? DEFAULT_MAX_TASKS,
    used: 0,
    reservations: new Map(),
  };

  tokens.set(entry.token, entry);
  return entry;
}

export function validateToken(
  raw: string | null | undefined,
  now: number = Date.now(),
): { ok: true; entry: DelegationTokenEntry } | { ok: false; reason: TokenRejection } {
  if (!raw) return { ok: false, reason: 'missing' };

  const entry = tokens.get(raw);
  if (!entry) return { ok: false, reason: 'unknown' };
  if (entry.expiresAt <= now) return { ok: false, reason: 'expired' };

  return { ok: true, entry };
}

export function revokeToken(raw: string): boolean {
  return tokens.delete(raw);
}

/**
 * Reserves this request id before anything can await. A second request with the
 * same id either reuses the finished task or waits on the same creation; it can
 * never start a second `createTask`.
 */
export function claimRequest(entry: DelegationTokenEntry, requestId: string): Claim {
  const existing = entry.reservations.get(requestId);

  if (existing?.state === 'created') return { type: 'reuse', taskId: existing.taskId };
  if (existing?.state === 'creating') return { type: 'wait', result: existing.result };

  if (entry.used >= entry.maxTasks) return { type: 'quota_exceeded' };

  let resolveResult: (outcome: CreationOutcome) => void = () => {};
  const result = new Promise<CreationOutcome>((resolve) => {
    resolveResult = resolve;
  });

  entry.used += 1;
  entry.reservations.set(requestId, { state: 'creating', result });

  return {
    type: 'owner',
    settle: (outcome) => {
      if (outcome.ok) {
        entry.reservations.set(requestId, { state: 'created', taskId: outcome.taskId });
      } else {
        // A failed creation produced no task, so it must not consume a slot.
        entry.reservations.delete(requestId);
        entry.used -= 1;
      }

      resolveResult(outcome);
    },
  };
}

/** Test hook: the store is process-wide, so tests must be able to clear it. */
export function resetTokens(): void {
  tokens.clear();
}
