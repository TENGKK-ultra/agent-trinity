import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import * as sessionService from '../harnesses/session.service.ts';
import type { HarnessType } from '../harnesses/types.ts';
import { appError, type Message } from '../types/index.ts';
import type { CheckpointRunner } from './checkpoint.service.ts';
import { findRound, type RoundRow } from './messages.service.ts';
import { coordinatorOf, listRoles } from './roles.service.ts';

export type ReviewStatus = 'pass' | 'needs_changes' | 'review_unavailable';

export interface ReviewRow {
  id: string;
  round_id: string;
  producer: string;
  reviewer: string | null;
  producer_model: string | null;
  reviewer_model: string | null;
  same_provider: number | null;
  status: ReviewStatus;
  findings_json: string | null;
  created_at: string;
}

export interface ReviewFindings {
  status: ReviewStatus;
  items: string[];
  note: string | null;
}

const PROVIDERS: Record<HarnessType, string> = {
  claude: 'anthropic',
  codex: 'openai',
  deepseek: 'deepseek',
};

export function providerOf(agent: HarnessType): string {
  return PROVIDERS[agent];
}

function modelOf(db: DatabaseSync, conversationId: string, agent: HarnessType): string | null {
  return sessionService.findSession(db, conversationId, agent)?.model ?? null;
}

/**
 * Picks a reviewer who did not produce the work (§6.5.1). A different provider
 * is preferred, then a different model; when only the producer is available the
 * round records `review_unavailable` rather than letting an agent approve itself.
 */
export function selectReviewer(
  db: DatabaseSync,
  roundId: string,
  producers: readonly HarnessType[],
  excluded: readonly HarnessType[] = [],
): HarnessType | null {
  const round = findRound(db, roundId);

  if (!round) throw appError('round_not_found', 'Round not found', 404);

  const refused = new Set<string>([...producers, ...excluded]);
  const candidates = listRoles(db, roundId)
    .map((row) => row.agent)
    .filter((agent): agent is HarnessType => !refused.has(agent))
    .filter((agent) => sessionService.findSession(db, round.conversation_id, agent) !== undefined);

  if (candidates.length === 0) return null;

  const producerProviders = new Set(producers.map((agent) => providerOf(agent)));
  const coordinator = coordinatorOf(db, roundId);

  const scored = candidates.map((agent) => {
    const differentProvider = producerProviders.has(providerOf(agent)) ? 0 : 2;
    const notCoordinator = agent === coordinator ? 0 : 1;

    return { agent, score: differentProvider + notCoordinator };
  });

  scored.sort((a, b) => b.score - a.score || a.agent.localeCompare(b.agent));

  return scored[0]?.agent ?? null;
}

const BLOCK = /```(?:collab|json)\s*\n([\s\S]*?)```/i;

function asItems(value: unknown): string[] {
  if (!Array.isArray(value)) return [];

  return value
    .map((item) => (typeof item === 'string' ? item.trim() : JSON.stringify(item)))
    .filter((item) => item !== '')
    .slice(0, 20);
}

/**
 * The reviewer answers with a block. Anything this cannot read is *not* a pass:
 * an unparsable review is recorded as unavailable, because "I could not tell"
 * and "it is fine" are different facts.
 */
export function parseReviewOutput(text: string): ReviewFindings {
  const match = BLOCK.exec(text);

  if (match) {
    try {
      const parsed = JSON.parse(match[1] ?? '') as Record<string, unknown>;
      const review = (parsed.review ?? parsed) as Record<string, unknown>;
      const status = review.status;
      const items = asItems(review.findings);

      if (status === 'pass') {
        return { status: 'pass', items, note: null };
      }

      if (status === 'needs_changes') {
        return { status: 'needs_changes', items, note: null };
      }
    } catch {
      // fall through
    }
  }

  return {
    status: 'review_unavailable',
    items: [],
    note: '审查输出不是可解析的结论',
  };
}

export function buildReviewPrompt(
  round: RoundRow,
  deliverable: string,
  producers: readonly HarnessType[],
): string {
  return [
    '[独立审查]',
    `本轮目标：${round.goal}`,
    `成果由 ${producers.join('、')} 产出，你是独立审查者。`,
    '',
    '请逐项检查：',
    '1. 内容是否完整、准确？',
    '2. 是否满足用户最初提出的要求？',
    '3. 有没有未经证实的说法或来源？',
    '4. 是否存在明显逻辑问题？',
    '5. 交付物是否真实存在、能被打开？',
    '',
    '待审成果：',
    deliverable,
    '[/独立审查]',
    '',
    '只输出一个 ```collab JSON 块，不要输出别的内容：',
    '{"review":{"status":"pass","findings":[]}}',
    '或',
    '{"review":{"status":"needs_changes","findings":["具体问题1","具体问题2"]}}',
  ].join('\n');
}

function insertReview(
  db: DatabaseSync,
  input: Omit<ReviewRow, 'id' | 'created_at'>,
): ReviewRow {
  const row: ReviewRow = {
    ...input,
    id: randomUUID(),
    created_at: new Date().toISOString(),
  };

  db.prepare(
    `INSERT INTO round_reviews
       (id, round_id, producer, reviewer, producer_model, reviewer_model,
        same_provider, status, findings_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.round_id,
    row.producer,
    row.reviewer,
    row.producer_model,
    row.reviewer_model,
    row.same_provider,
    row.status,
    row.findings_json,
    row.created_at,
  );

  return row;
}

export interface RunReviewInput {
  round: RoundRow;
  producers: readonly HarnessType[];
  /** Agents that must not review even if they produced nothing (the coordinator). */
  excluded?: readonly HarnessType[];
  deliverable: string;
  runner: CheckpointRunner;
}

/** Records that no independent review could happen — never a silent pass. */
export function recordUnavailableReview(
  db: DatabaseSync,
  round: RoundRow,
  producers: readonly HarnessType[],
  reason: string,
): ReviewRow {
  const producerModel = producers
    .map((agent) => modelOf(db, round.conversation_id, agent))
    .filter((model): model is string => model !== null)
    .join(',') || null;

  return insertReview(db, {
    round_id: round.id,
    producer: producers.join(',') || 'unknown',
    reviewer: null,
    producer_model: producerModel,
    reviewer_model: null,
    same_provider: null,
    status: 'review_unavailable',
    findings_json: JSON.stringify([reason]),
  });
}

/**
 * Runs one review. The reviewer is chosen here, so a caller cannot hand-pick a
 * friendly one; when nobody independent is bound the row says so.
 */
export async function runReview(
  db: DatabaseSync,
  input: RunReviewInput,
): Promise<ReviewRow> {
  const { round } = input;
  const reviewer = selectReviewer(db, round.id, input.producers, input.excluded ?? []);

  const producerModel = input.producers
    .map((agent) => modelOf(db, round.conversation_id, agent))
    .filter((model): model is string => model !== null)
    .join(',') || null;

  if (reviewer === null) {
    return insertReview(db, {
      round_id: round.id,
      producer: input.producers.join(',') || 'unknown',
      reviewer: null,
      producer_model: producerModel,
      reviewer_model: null,
      same_provider: null,
      status: 'review_unavailable',
      findings_json: JSON.stringify(['没有可用的独立审查者']),
    });
  }

  const prompt = buildReviewPrompt(round, input.deliverable, input.producers);
  let result: { ok: boolean; text: string | null } = { ok: false, text: null };

  try {
    result = await input.runner({
      db,
      agent: reviewer,
      conversationId: round.conversation_id,
      roundId: round.id,
      prompt,
    });
  } catch {
    result = { ok: false, text: null };
  }

  if (!result.ok || result.text === null) {
    return insertReview(db, {
      round_id: round.id,
      producer: input.producers.join(',') || 'unknown',
      reviewer,
      producer_model: producerModel,
      reviewer_model: modelOf(db, round.conversation_id, reviewer),
      same_provider: input.producers.some(
        (agent) => providerOf(agent) === providerOf(reviewer),
      )
        ? 1
        : 0,
      status: 'review_unavailable',
      findings_json: JSON.stringify(['审查回合没有产生可读结论']),
    });
  }

  const findings = parseReviewOutput(result.text);

  return insertReview(db, {
    round_id: round.id,
    producer: input.producers.join(',') || 'unknown',
    reviewer,
    producer_model: producerModel,
    reviewer_model: modelOf(db, round.conversation_id, reviewer),
    same_provider: input.producers.some(
      (agent) => providerOf(agent) === providerOf(reviewer),
    )
      ? 1
      : 0,
    status: findings.status,
    findings_json: JSON.stringify(
      findings.note === null ? findings.items : [...findings.items, findings.note],
    ),
  });
}

export function listReviews(db: DatabaseSync, roundId: string): ReviewRow[] {
  return db
    .prepare('SELECT * FROM round_reviews WHERE round_id = ? ORDER BY created_at, rowid')
    .all(roundId) as unknown as ReviewRow[];
}

export function findingsOf(row: ReviewRow): string[] {
  if (row.findings_json === null) return [];

  try {
    const parsed = JSON.parse(row.findings_json) as unknown;
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
  } catch {
    return [];
  }
}

/** The chat message that carries a delivery, if one was written. */
export function deliveryMessage(db: DatabaseSync, messageId: string | null): Message | null {
  if (messageId === null) return null;

  return (db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId) as unknown as Message) ?? null;
}
