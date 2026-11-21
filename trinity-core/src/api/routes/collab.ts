import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import * as conversationRepository from '../../conversations/conversation.repository.ts';
import { ensureObject, parseBoundedInteger } from '../../common/validation.ts';
import {
  cancelCollaboration,
  listAllRounds,
  listRounds,
  resumeCollaboration,
  roundDetail,
  startCollaboration,
} from '../../collab/orchestrator.service.ts';
import { findingsOf } from '../../collab/review.service.ts';
import type { RoundRow } from '../../collab/messages.service.ts';
import type { CoreRuntime } from '../../harnesses/runtime.ts';
import type { TaskRow } from '../../harnesses/task.service.ts';
import { appError } from '../../types/index.ts';
import { queryObject, readJsonBody, sendJson } from '../http-utils.ts';

const MAX_GOAL_LENGTH = 8000;
const MAX_PREVIEW_CHARS = 4000;

function optionalString(value: unknown, field: string, maxLength = 64): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw appError(`invalid_${field}`, `${field} must be a string`, 400);
  }

  const text = value.trim();

  if (text === '') return undefined;
  if (text.length > maxLength) {
    throw appError(`invalid_${field}`, `${field} is too long`, 400);
  }

  return text;
}

function optionalInteger(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null) return undefined;

  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw appError(`invalid_${field}`, `${field} must be a non-negative integer`, 400);
  }

  return value;
}

function stringList(value: unknown, field: string): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw appError(`invalid_${field}`, `${field} must be an array`, 400);
  }

  return value.map((item) => {
    if (typeof item !== 'string') {
      throw appError(`invalid_${field}`, `${field} must contain strings`, 400);
    }

    return item.trim();
  }).filter((item) => item !== '');
}

export function roundDto(round: RoundRow): Record<string, unknown> {
  return {
    id: round.id,
    conversation_id: round.conversation_id,
    goal: round.goal,
    status: round.status,
    outcome: round.outcome,
    coordinator: round.coordinator,
    review_required: round.review_required === 1,
    min_assignments: round.min_assignments,
    blocked_phase: round.blocked_phase,
    budgets: {
      hops: { used: round.hops_used, limit: round.budget_hops },
      exec: { used: round.exec_used, limit: round.budget_exec },
      usage_tokens: { limit: round.budget_usage_tokens },
    },
    blocked_reason: round.blocked_reason,
    wake_condition: round.wake_condition,
    delivery_message_id: round.delivery_message_id,
    created_at: round.created_at,
    closed_at: round.closed_at,
  };
}

function taskDto(task: TaskRow): Record<string, unknown> {
  return {
    id: task.id,
    target_agent: task.target_agent,
    source_agent: task.source_agent,
    task_type: task.task_type,
    title: task.title,
    instruction_preview:
      task.instruction.length > MAX_PREVIEW_CHARS
        ? `${task.instruction.slice(0, MAX_PREVIEW_CHARS)}…`
        : task.instruction,
    status: task.status,
    error_text: task.error_text,
    result_message_id: task.result_message_id,
    created_at: task.created_at,
    started_at: task.started_at,
    finished_at: task.finished_at,
  };
}

function deliveryOf(db: DatabaseSync, round: RoundRow): Record<string, unknown> | null {
  if (round.delivery_message_id === null) return null;

  const row = db
    .prepare('SELECT id, content, message_type, created_at FROM messages WHERE id = ?')
    .get(round.delivery_message_id) as
    | { id: string; content: string; message_type: string; created_at: string }
    | undefined;

  return row ?? null;
}

async function createRound(
  db: DatabaseSync,
  req: IncomingMessage,
  res: ServerResponse,
  conversationId: string,
  runtime: CoreRuntime,
): Promise<void> {
  const body = ensureObject(await readJsonBody(req));
  const goal = optionalString(body.goal, 'goal', MAX_GOAL_LENGTH);

  if (goal === undefined) {
    throw appError('invalid_goal', 'goal must not be empty', 400);
  }

  const coordinator = optionalString(body.coordinator, 'coordinator', 32);
  const targets = stringList(body.targets, 'targets');
  const contributors = stringList(body.contributors, 'contributors');
  const budgetHops = optionalInteger(body.budget_hops, 'budget_hops');
  const budgetExec = optionalInteger(body.budget_exec, 'budget_exec');
  const budgetUsageTokens = optionalInteger(body.budget_usage_tokens, 'budget_usage_tokens');
  const minAssignments = optionalInteger(body.min_assignments, 'min_assignments');

  const result = startCollaboration(
    db,
    conversationId,
    {
      goal,
      ...(coordinator === undefined ? {} : { coordinator }),
      ...(targets === undefined ? {} : { targets }),
      ...(contributors === undefined ? {} : { contributors }),
      ...(typeof body.review_required === 'boolean'
        ? { reviewRequired: body.review_required }
        : {}),
      ...(budgetHops === undefined ? {} : { budgetHops }),
      ...(budgetExec === undefined ? {} : { budgetExec }),
      ...(budgetUsageTokens === undefined ? {} : { budgetUsageTokens }),
      ...(minAssignments === undefined ? {} : { minAssignments }),
    },
    { runtime },
  );

  // The round runs in the background; the caller gets its identity at once.
  void result.completion.catch(() => undefined);

  sendJson(res, 202, {
    round: roundDto(result.round),
    goal_message_id: result.goalMessageId,
  });
}

function listForConversation(
  db: DatabaseSync,
  req: IncomingMessage,
  res: ServerResponse,
  conversationId: string,
  url: URL,
): void {
  if (req.method !== 'GET') {
    throw appError('method_not_allowed', `Method ${req.method} is not allowed`, 405);
  }

  const params = queryObject(url);
  const limit = parseBoundedInteger(params.limit, 'limit', {
    min: 1,
    max: 100,
    defaultValue: 30,
  });

  sendJson(res, 200, { items: listRounds(db, conversationId, limit).map(roundDto) });
}

function detail(
  db: DatabaseSync,
  req: IncomingMessage,
  res: ServerResponse,
  conversationId: string,
  roundId: string,
): void {
  if (req.method !== 'GET') {
    throw appError('method_not_allowed', `Method ${req.method} is not allowed`, 405);
  }

  const detail = roundDetail(db, roundId);

  if (detail.round.conversation_id !== conversationId) {
    throw appError('round_not_found', 'Round not found', 404);
  }

  sendJson(res, 200, {
    round: roundDto(detail.round),
    roles: detail.roles,
    tasks: detail.tasks.map(taskDto),
    messages: detail.messages.map((message) => ({
      id: message.id,
      kind: message.kind,
      from_agent: message.from_agent,
      to_agent: message.to_agent,
      content: message.content,
      reason: message.reason,
      state: message.state,
      hop: message.hop,
      task_id: message.task_id,
      created_at: message.created_at,
    })),
    contributions: detail.contributions.map((row) => ({
      id: row.id,
      agent: row.agent,
      phase: row.phase,
      content: row.content,
      message_id: row.message_id,
      created_at: row.created_at,
    })),
    reviews: detail.reviews.map((review) => ({
      id: review.id,
      producer: review.producer,
      reviewer: review.reviewer,
      same_provider: review.same_provider === null ? null : review.same_provider === 1,
      status: review.status,
      findings: findingsOf(review),
      created_at: review.created_at,
    })),
    usage: {
      tokens: detail.usage.tokens,
      cost_usd: detail.usage.costUsd,
      rows: detail.usage.rows,
    },
    delivery: deliveryOf(db, detail.round),
  });
}

function cancel(
  db: DatabaseSync,
  req: IncomingMessage,
  res: ServerResponse,
  conversationId: string,
  roundId: string,
): void {
  if (req.method !== 'POST') {
    throw appError('method_not_allowed', `Method ${req.method} is not allowed`, 405);
  }

  const round = roundDetail(db, roundId).round;

  if (round.conversation_id !== conversationId) {
    throw appError('round_not_found', 'Round not found', 404);
  }

  sendJson(res, 200, { round: roundDto(cancelCollaboration(db, roundId)) });
}

async function resume(
  db: DatabaseSync,
  req: IncomingMessage,
  res: ServerResponse,
  conversationId: string,
  roundId: string,
  runtime: CoreRuntime,
): Promise<void> {
  if (req.method !== 'POST') {
    throw appError('method_not_allowed', `Method ${req.method} is not allowed`, 405);
  }

  const round = roundDetail(db, roundId).round;

  if (round.conversation_id !== conversationId) {
    throw appError('round_not_found', 'Round not found', 404);
  }

  const body = ensureObject(await readJsonBody(req));
  const tokens = optionalInteger(body.budget_usage_tokens, 'budget_usage_tokens');
  const hops = optionalInteger(body.budget_hops, 'budget_hops');
  const minAssignments = optionalInteger(body.min_assignments, 'min_assignments');
  const retryPlanning = body.retry_planning === true;

  // The service knows which kind of block this is: a budget block needs a new
  // ceiling, a requirement block can be relaxed or retried instead.
  const result = resumeCollaboration(
    db,
    roundId,
    {
      ...(tokens === undefined ? {} : { budgetUsageTokens: tokens }),
      ...(hops === undefined ? {} : { budgetHops: hops }),
      ...(minAssignments === undefined ? {} : { minAssignments }),
      ...(retryPlanning ? { retryPlanning: true } : {}),
    },
    { runtime },
  );

  sendJson(res, 202, { round: roundDto(result.round) });
}

/**
 * `/api/conversations/:id/collab/...` — starting, watching and stopping a round.
 * Nothing here manufactures progress: the round advances only by real turns.
 */
export async function handleCollab(
  db: DatabaseSync,
  req: IncomingMessage,
  res: ServerResponse,
  segments: string[],
  url: URL,
  runtime: CoreRuntime,
): Promise<void> {
  const conversationId = decodeURIComponent(segments[2] ?? '');

  if (!conversationRepository.findConversation(db, conversationId)) {
    throw appError('conversation_not_found', 'Conversation not found', 404);
  }

  // /api/conversations/:id/collab/rounds
  if (segments.length === 5 && segments[4] === 'rounds') {
    if (req.method === 'POST') {
      await createRound(db, req, res, conversationId, runtime);
      return;
    }

    listForConversation(db, req, res, conversationId, url);
    return;
  }

  if (segments.length >= 6 && segments[4] === 'rounds') {
    const roundId = decodeURIComponent(segments[5] ?? '');

    if (segments.length === 6) {
      detail(db, req, res, conversationId, roundId);
      return;
    }

    if (segments.length === 7 && segments[6] === 'cancel') {
      cancel(db, req, res, conversationId, roundId);
      return;
    }

    if (segments.length === 7 && segments[6] === 'resume') {
      await resume(db, req, res, conversationId, roundId, runtime);
      return;
    }
  }

  throw appError('not_found', 'Not found', 404);
}

/** `/api/collab/rounds` — every round, for the workspace view. */
export function handleAllRounds(
  db: DatabaseSync,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
): void {
  if (req.method !== 'GET') {
    throw appError('method_not_allowed', `Method ${req.method} is not allowed`, 405);
  }

  const params = queryObject(url);
  const limit = parseBoundedInteger(params.limit, 'limit', {
    min: 1,
    max: 200,
    defaultValue: 50,
  });

  sendJson(res, 200, {
    items: listAllRounds(db, limit).map((round) => ({
      ...roundDto(round),
      conversation_title: round.conversation_title,
    })),
  });
}
