import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { HarnessType } from '../harnesses/types.ts';
import { appError } from '../types/index.ts';
import { findRound } from './messages.service.ts';

export type ContributionPhase = 'planning' | 'checkpoint' | 'rework';

export interface ContributionRow {
  id: string;
  round_id: string;
  conversation_id: string;
  agent: string;
  phase: ContributionPhase;
  content: string;
  message_id: string | null;
  created_at: string;
}

/** Fewer characters than this is a status line, not something delivered. */
const MIN_CONTENT_CHARS = 30;
/** A round can record its process, not an entire transcript. */
const MAX_PER_ROUND = 10;

const PLAN_BLOCK = /```(?:collab|json)\s*\n[\s\S]*?```/gi;

/**
 * What the coordinator actually said, with its machine instructions removed.
 * The plan block is addressed to Core; the prose around it is addressed to the
 * user, and that is the part that can be reviewed.
 */
export function contributionText(raw: string): string {
  return raw.replace(PLAN_BLOCK, '').replace(/\n{3,}/g, '\n\n').trim();
}

export function listContributions(db: DatabaseSync, roundId: string): ContributionRow[] {
  return db
    .prepare('SELECT * FROM round_contributions WHERE round_id = ? ORDER BY created_at, rowid')
    .all(roundId) as unknown as ContributionRow[];
}

/**
 * Records one successful turn's prose as a contribution.
 *
 * It is deliberately not a task: no recipient, no delivery state, no chain. It
 * returns null when the turn carried only a plan, repeated an earlier
 * contribution verbatim, or the round already holds the maximum.
 */
export function recordContribution(
  db: DatabaseSync,
  input: {
    roundId: string;
    agent: HarnessType;
    phase: ContributionPhase;
    text: string;
    messageId?: string | null;
  },
): ContributionRow | null {
  const content = contributionText(input.text);

  if (content.length < MIN_CONTENT_CHARS) return null;

  const round = findRound(db, input.roundId);

  if (!round) throw appError('round_not_found', 'Round not found', 404);

  const duplicate = db
    .prepare('SELECT id FROM round_contributions WHERE round_id = ? AND content = ?')
    .get(input.roundId, content) as { id: string } | undefined;

  if (duplicate) return null;

  const total = (
    db
      .prepare('SELECT COUNT(*) AS n FROM round_contributions WHERE round_id = ?')
      .get(input.roundId) as { n: number }
  ).n;

  if (Number(total) >= MAX_PER_ROUND) return null;

  const row: ContributionRow = {
    id: randomUUID(),
    round_id: input.roundId,
    conversation_id: round.conversation_id,
    agent: input.agent,
    phase: input.phase,
    content,
    message_id: input.messageId ?? null,
    created_at: new Date().toISOString(),
  };

  db.prepare(
    `INSERT INTO round_contributions
       (id, round_id, conversation_id, agent, phase, content, message_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.round_id,
    row.conversation_id,
    row.agent,
    row.phase,
    row.content,
    row.message_id,
    row.created_at,
  );

  return row;
}

/** The agents whose own turns produced deliverable text in this round. */
export function contributorsOf(db: DatabaseSync, roundId: string): Set<string> {
  const rows = db
    .prepare('SELECT DISTINCT agent FROM round_contributions WHERE round_id = ?')
    .all(roundId) as Array<{ agent: string }>;

  return new Set(rows.map((row) => row.agent));
}
